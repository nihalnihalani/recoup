/// <reference types="vite/client" />
/**
 * Tests for the T20a e2e seeding/reset harness (`./testing.ts`, D83/D95/D102).
 *
 * Covers: the `assertE2EEnabled()` gate on every exported function (env
 * unset -> throws; env set but `CONVEX_SITE_URL` matches the documented
 * production host -> throws anyway); `seedUser` creates a verified user
 * through the real Password auth path; `seedFixtures` writes only rows
 * owned by the target user, none `isExample`; `resetUser` deletes
 * everything seeded for an email, children first; `lastCodeFor` reads a
 * manually written `opsState` row.
 */
import { afterEach, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { setup } from "./test.setup";
import type { Id } from "./_generated/dataModel";

const DEV_SITE_URL = "https://adorable-lion-138.convex.site";
const PROD_SITE_URL = "https://cool-oyster-399.convex.site";

const ENV_KEYS = ["E2E_SEED_ENABLED", "CONVEX_SITE_URL"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let saved: Partial<Record<EnvKey, string | undefined>> = {};

function saveEnv(): void {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
function enableE2E(siteUrl: string = DEV_SITE_URL): void {
  process.env.E2E_SEED_ENABLED = "true";
  process.env.CONVEX_SITE_URL = siteUrl;
}
function disableE2E(): void {
  delete process.env.E2E_SEED_ENABLED;
  process.env.CONVEX_SITE_URL = DEV_SITE_URL;
}

async function worldFor(t: ReturnType<typeof setup>, userId: Id<"users">) {
  return t.run(async (ctx) => {
    const watches = await ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const purchases = await ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const items = await ctx.db.query("items").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const claims = await ctx.db.query("claims").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const offers = await ctx.db.query("offers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const mailLog = await ctx.db.query("mailLog").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const watchChecks = (await ctx.db.query("watchChecks").collect()).filter((r) => r.userId === userId);
    const priceChecks = (await ctx.db.query("priceChecks").collect()).filter((r) => r.userId === userId);
    const policies = (await ctx.db.query("policies").collect()).filter((r) => r.userId === userId);
    const authAccounts = (await ctx.db.query("authAccounts").collect()).filter((r) => r.userId === userId);
    const user = await ctx.db.get(userId);
    return { watches, purchases, items, claims, offers, mailLog, watchChecks, priceChecks, policies, authAccounts, user };
  });
}

describe("convex/testing.ts — assertE2EEnabled gating", () => {
  afterEach(restoreEnv);

  it("seedUser throws when E2E_SEED_ENABLED is unset", async () => {
    saveEnv();
    disableE2E();
    const t = setup();
    await expect(t.action(internal.testing.seedUser, { email: "gate@example.com" })).rejects.toThrow();
  });

  it("seedUser throws when enabled but CONVEX_SITE_URL matches the production host", async () => {
    saveEnv();
    enableE2E(PROD_SITE_URL);
    const t = setup();
    await expect(t.action(internal.testing.seedUser, { email: "gate@example.com" })).rejects.toThrow();
  });

  it("seedFixtures throws when E2E_SEED_ENABLED is unset", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const { userId } = await t.action(internal.testing.seedUser, { email: "gate-fixtures@example.com" });
    disableE2E();
    await expect(t.mutation(internal.testing.seedFixtures, { userId })).rejects.toThrow();
  });

  it("seedFixtures throws when enabled but CONVEX_SITE_URL matches the production host", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const { userId } = await t.action(internal.testing.seedUser, { email: "gate-fixtures-2@example.com" });
    process.env.CONVEX_SITE_URL = PROD_SITE_URL;
    await expect(t.mutation(internal.testing.seedFixtures, { userId })).rejects.toThrow();
  });

  it("lastCodeFor throws when E2E_SEED_ENABLED is unset", async () => {
    saveEnv();
    disableE2E();
    const t = setup();
    await expect(t.query(internal.testing.lastCodeFor, { email: "gate@example.com" })).rejects.toThrow();
  });

  it("lastCodeFor throws when enabled but CONVEX_SITE_URL matches the production host", async () => {
    saveEnv();
    enableE2E(PROD_SITE_URL);
    const t = setup();
    await expect(t.query(internal.testing.lastCodeFor, { email: "gate@example.com" })).rejects.toThrow();
  });

  it("resetUser throws when E2E_SEED_ENABLED is unset", async () => {
    saveEnv();
    disableE2E();
    const t = setup();
    await expect(t.mutation(internal.testing.resetUser, { email: "gate@example.com" })).rejects.toThrow();
  });

  it("resetUser throws when enabled but CONVEX_SITE_URL matches the production host", async () => {
    saveEnv();
    enableE2E(PROD_SITE_URL);
    const t = setup();
    await expect(t.mutation(internal.testing.resetUser, { email: "gate@example.com" })).rejects.toThrow();
  });
});

describe("convex/testing.ts — seedUser", () => {
  afterEach(restoreEnv);

  it("creates a verified user through the real Password auth path, email normalized", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const { userId } = await t.action(internal.testing.seedUser, {
      email: "  E2E.Lead@Example.com  ",
      password: "E2ePassword123!",
    });

    const { user, authAccounts } = await worldFor(t, userId);
    expect(user?.email).toBe("e2e.lead@example.com");
    expect(user?.emailVerificationTime).toBeTypeOf("number");
    expect(authAccounts).toHaveLength(1);
    expect(authAccounts[0]?.provider).toBe("password");
    expect(authAccounts[0]?.providerAccountId).toBe("e2e.lead@example.com");
    expect(authAccounts[0]?.secret).toBeTruthy();
  });

  it("defaults the password when none is supplied", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const { userId } = await t.action(internal.testing.seedUser, { email: "default-pw@example.com" });
    const { user } = await worldFor(t, userId);
    expect(user?.emailVerificationTime).toBeTypeOf("number");
  });

  it("is idempotent for the same email+password, but throws for a different password against an already-seeded email", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const first = await t.action(internal.testing.seedUser, { email: "repeat@example.com", password: "E2ePassword123!" });
    const second = await t.action(internal.testing.seedUser, { email: "repeat@example.com", password: "E2ePassword123!" });
    expect(second.userId).toBe(first.userId);

    await expect(
      t.action(internal.testing.seedUser, { email: "repeat@example.com", password: "SomeOtherPassword456!" }),
    ).rejects.toThrow();
  });

  it("rejects a password outside the 8-128 character range", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    await expect(t.action(internal.testing.seedUser, { email: "short-pw@example.com", password: "short" })).rejects.toThrow();
  });
});

describe("convex/testing.ts — seedFixtures", () => {
  afterEach(restoreEnv);

  it("creates only rows owned by the target user, none isExample, and leaves a second user untouched", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const { userId: userA } = await t.action(internal.testing.seedUser, { email: "fixtures-a@example.com" });
    const { userId: userB } = await t.action(internal.testing.seedUser, { email: "fixtures-b@example.com" });

    const result = await t.mutation(internal.testing.seedFixtures, { userId: userA });
    expect(result.offerIds).toHaveLength(3);
    expect(result.mailLogIds).toHaveLength(2);

    const a = await worldFor(t, userA);
    expect(a.watches).toHaveLength(2);
    expect(a.watchChecks).toHaveLength(3);
    expect(a.purchases).toHaveLength(2);
    expect(a.items).toHaveLength(2);
    expect(a.priceChecks).toHaveLength(13); // 12 on the bought item + 1 on the claim item
    expect(a.policies).toHaveLength(2); // price_adjustment + returns
    expect(a.claims).toHaveLength(1);
    expect(a.claims[0]?.status).toBe("detected");
    expect(a.claims[0]?.type).toBe("price_adjustment");
    expect(a.offers).toHaveLength(3);
    expect(a.offers.map((o) => o.status).sort()).toEqual(["candidate", "candidate", "confirmed"]);
    expect(a.offers.some((o) => o.source === "shopsavvy" && o.note?.includes("Out of stock"))).toBe(true);
    expect(a.mailLog).toHaveLength(2);
    expect(a.mailLog.map((m) => m.status).sort()).toEqual(["queued", "sent"]);

    for (const row of [...a.watches, ...a.purchases, ...a.items, ...a.claims, ...a.offers, ...a.mailLog, ...a.watchChecks, ...a.priceChecks, ...a.policies]) {
      expect(row.userId).toBe(userA);
    }
    for (const row of [...a.purchases, ...a.claims, ...a.policies]) {
      expect((row as { isExample?: boolean }).isExample).toBeUndefined();
    }

    const b = await worldFor(t, userB);
    expect(b.watches).toHaveLength(0);
    expect(b.purchases).toHaveLength(0);
    expect(b.items).toHaveLength(0);
    expect(b.claims).toHaveLength(0);
    expect(b.offers).toHaveLength(0);
    expect(b.mailLog).toHaveLength(0);
    expect(b.watchChecks).toHaveLength(0);
    expect(b.priceChecks).toHaveLength(0);
    expect(b.policies).toHaveLength(0);
  });

  it("throws for a userId with no user row", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const bogusId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { name: "throwaway" });
      await ctx.db.delete(id);
      return id;
    });
    await expect(t.mutation(internal.testing.seedFixtures, { userId: bogusId })).rejects.toThrow();
  });
});

describe("convex/testing.ts — lastCodeFor", () => {
  afterEach(restoreEnv);

  it("reads a manually written opsState row, keyed by normalized email", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("opsState", { key: "e2e:code:code-check@example.com", cursor: "87654321", updatedAt: Date.now() });
    });

    const exact = await t.query(internal.testing.lastCodeFor, { email: "code-check@example.com" });
    expect(exact).toBe("87654321");

    const paddedAndCased = await t.query(internal.testing.lastCodeFor, { email: "  Code-Check@Example.com " });
    expect(paddedAndCased).toBe("87654321");
  });

  it("returns null when no code has been captured for the address", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const missing = await t.query(internal.testing.lastCodeFor, { email: "never-sent@example.com" });
    expect(missing).toBeNull();
  });
});

describe("convex/testing.ts — resetUser", () => {
  afterEach(restoreEnv);

  it("deletes every row seedUser/seedFixtures created, plus the opsState code row, children first", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const email = "reset-me@example.com";
    const { userId } = await t.action(internal.testing.seedUser, { email });
    await t.mutation(internal.testing.seedFixtures, { userId });
    await t.run(async (ctx) => {
      await ctx.db.insert("opsState", { key: `e2e:code:${email}`, cursor: "11112222", updatedAt: Date.now() });
    });

    const before = await worldFor(t, userId);
    expect(before.watches.length).toBeGreaterThan(0);

    const result = await t.mutation(internal.testing.resetUser, { email });
    expect(result.deleted).toBe(true);

    const after = await worldFor(t, userId);
    expect(after.user).toBeNull();
    expect(after.watches).toHaveLength(0);
    expect(after.purchases).toHaveLength(0);
    expect(after.items).toHaveLength(0);
    expect(after.claims).toHaveLength(0);
    expect(after.offers).toHaveLength(0);
    expect(after.mailLog).toHaveLength(0);
    expect(after.watchChecks).toHaveLength(0);
    expect(after.priceChecks).toHaveLength(0);
    expect(after.policies).toHaveLength(0);
    expect(after.authAccounts).toHaveLength(0);

    const remainingChildren = await t.run(async (ctx) => ({
      claimNotes: await ctx.db.query("claimNotes").collect(),
      ledgerEvents: await ctx.db.query("ledgerEvents").collect(),
      offerChecks: await ctx.db.query("offerChecks").collect(),
      code: await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", `e2e:code:${email}`)).unique(),
    }));
    expect(remainingChildren.claimNotes).toHaveLength(0);
    expect(remainingChildren.ledgerEvents).toHaveLength(0);
    expect(remainingChildren.offerChecks).toHaveLength(0);
    expect(remainingChildren.code).toBeNull();
  });

  it("is a no-op (deleted: false) for an email that was never seeded", async () => {
    saveEnv();
    enableE2E();
    const t = setup();
    const result = await t.mutation(internal.testing.resetUser, { email: "nobody-here@example.com" });
    expect(result.deleted).toBe(false);
  });
});
